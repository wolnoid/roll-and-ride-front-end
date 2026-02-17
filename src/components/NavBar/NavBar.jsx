import { useContext } from 'react';
import { useNavigate } from 'react-router';
import styles from './NavBar.module.css';
import Logo from '../../assets/images/logo1.png';
import TextLogo from '../../assets/images/text1.png';
import { UserContext } from '../../contexts/UserContext';
import { clearToken } from '../../services/tokenService';
import { requestAuthSidebarExpand } from '../../utils/authSidebarState';

const NavBar = () => {
  const navigate = useNavigate();
  const { user, setUser } = useContext(UserContext);

  const handleAuthClick = () => {
    if (user) {
      clearToken();
      setUser(null);
      navigate('/');
      return;
    }

    requestAuthSidebarExpand();
    navigate('/sign-in');
  };

  return (
    <nav className={styles.container}>
      <div className={styles.left}>
        <a href="/">
          <img className={styles.logo} src={Logo} alt="logo" />
        </a>
      </div>

      <div className={styles.center}>
        <img className={styles.textLogo} src={TextLogo} alt='Roll & Ride' />
      </div>

      <div className={styles.right}>
        <button
          type='button'
          className={`${styles.authBtn} ${user ? styles.authBtnSignOut : ''}`}
          onClick={handleAuthClick}
        >
          {user ? 'Sign Out' : 'Sign In'}
        </button>
      </div>
    </nav>
  );
};

export default NavBar;
